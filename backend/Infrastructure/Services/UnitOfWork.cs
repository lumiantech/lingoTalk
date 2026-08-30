using System.Text.Json;
using Core.Entities;
using Core.Entities.Events;
using Core.Interfaces;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Infrastructure.Services;

public sealed class UnitOfWork : IUnitOfWork
{
    private readonly AppDbContext _dbContext;
    private readonly IUserContext _userContext;

    private IDbContextTransaction? _contextTransaction;
    private bool _completed;

    public UnitOfWork(
        AppDbContext dbContext,
        IUserContext userContext)
    {
        _dbContext = dbContext;
        _userContext = userContext;
    }

    public async Task BeginAsync(
        CancellationToken ct = default)
    {
        if (_contextTransaction != null)
        {
            await _contextTransaction.DisposeAsync();
            _contextTransaction = null;
        }

        _completed = false;

        _contextTransaction =
            await _dbContext.Database.BeginTransactionAsync(ct);
    }

    public void Enqueue(
        string type,
        string aggregateId,
        object payload)
    {
        _dbContext.OutboxEvents.Add(
            new OutboxEvent
            {
                Type = type,
                AggregateId = aggregateId,
                PayloadJson = JsonSerializer.Serialize(payload)
            });
    }

    public async Task<int> SaveChangesAsync(
        CancellationToken ct = default)
    {
        ApplyAudits();

        return await _dbContext.SaveChangesAsync(ct);
    }

    public async Task CommitAsync(
        CancellationToken ct = default)
    {
        if (_completed)
            return;

        if (_contextTransaction != null)
        {
            await _contextTransaction.CommitAsync(ct);
            await _contextTransaction.DisposeAsync();

            _contextTransaction = null;
        }

        _completed = true;
    }

    public async Task RollbackAsync(
        CancellationToken ct = default)
    {
        if (_completed)
            return;

        if (_contextTransaction != null)
        {
            try
            {
                await _contextTransaction.RollbackAsync(ct);
            }
            catch (ObjectDisposedException)
            {
            }
            finally
            {
                await _contextTransaction.DisposeAsync();
                _contextTransaction = null;
            }
        }

        _completed = true;
    }

    public async Task SaveChangesAndCommitAsync(
        CancellationToken ct = default)
    {
        await SaveChangesAsync(ct);
        await CommitAsync(ct);
    }

    public async Task InTransactionAsync(
        Func<CancellationToken, Task> work,
        CancellationToken ct = default)
    {
        await BeginAsync(ct);

        try
        {
            await work(ct);

            await SaveChangesAsync(ct);
            await CommitAsync(ct);
        }
        catch
        {
            await RollbackAsync(ct);
            throw;
        }
    }

    public async Task<T> InTransactionAsync<T>(
        Func<CancellationToken, Task<T>> work,
        CancellationToken ct = default)
    {
        await BeginAsync(ct);

        try
        {
            var result = await work(ct);

            await SaveChangesAsync(ct);
            await CommitAsync(ct);

            return result;
        }
        catch
        {
            await RollbackAsync(ct);
            throw;
        }
    }

    private void ApplyAudits()
    {
        var now = DateTime.UtcNow;

        var user =
            _userContext.UserName
            ?? _userContext.UserId
            ?? "system";

        foreach (var entry in
                 _dbContext.ChangeTracker.Entries<BaseEntity>())
        {
            if (entry.State == EntityState.Added)
            {
                entry.Entity.CreatedAt = now;
                entry.Entity.CreatedBy ??= user;

                entry.Entity.UpdatedAt = null;
                entry.Entity.UpdatedBy = null;
            }
            else if (entry.State == EntityState.Modified)
            {
                var hasBusinessChanges =
                    entry.Properties.Any(p =>
                        p.IsModified &&
                        p.Metadata.Name is not
                            ("CreatedAt"
                            or "CreatedBy"
                            or "UpdatedAt"
                            or "UpdatedBy"));

                if (!hasBusinessChanges)
                    continue;

                entry.Entity.UpdatedAt = now;
                entry.Entity.UpdatedBy = user;
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_contextTransaction != null &&
            !_completed)
        {
            try
            {
                await _contextTransaction.RollbackAsync();
            }
            catch (ObjectDisposedException)
            {
            }
            finally
            {
                await _contextTransaction.DisposeAsync();
                _contextTransaction = null;
            }
        }
    }
}