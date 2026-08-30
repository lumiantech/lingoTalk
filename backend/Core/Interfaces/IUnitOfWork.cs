namespace Core.Interfaces;

public interface IUnitOfWork : IOutboxWriter, IAsyncDisposable
{
    Task BeginAsync(CancellationToken ct = default);

    Task<int> SaveChangesAsync(CancellationToken ct = default);
    Task CommitAsync(CancellationToken ct = default);
    Task RollbackAsync(CancellationToken ct = default);
    Task SaveChangesAndCommitAsync(CancellationToken ct = default);

    Task InTransactionAsync(Func<CancellationToken, Task> work,
         CancellationToken ct = default);

    Task<T> InTransactionAsync<T>(Func<CancellationToken, Task<T>> work,
        CancellationToken ct = default);
}