using Core.DTOs;
using Core.Entities;
using Core.Interfaces;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Services;

public sealed class UserProvisioningService : IUserProvisioningService
{
    private readonly AppDbContext _db;

    public UserProvisioningService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<User> GetOrCreateAsync(
        FirebaseUserDto firebaseUser,
        CancellationToken ct = default)
    {
        var user = await _db.Users
            .SingleOrDefaultAsync(
                x => x.FirebaseUid == firebaseUser.Uid,
                ct);

        if (user is not null)
        {
            return user;
        }

        if (!string.IsNullOrWhiteSpace(firebaseUser.Email))
        {
            var normalizedEmail =
                firebaseUser.Email.Trim().ToLowerInvariant();

            user = await _db.Users
                .SingleOrDefaultAsync(
                    x => x.Email == normalizedEmail,
                    ct);

            if (user is not null)
            {
                user.FirebaseUid = firebaseUser.Uid;

                if (!string.IsNullOrWhiteSpace(firebaseUser.Name))
                {
                    user.DisplayName = firebaseUser.Name;
                }

                await _db.SaveChangesAsync(ct);

                return user;
            }
        }

        user = new User
        {
            FirebaseUid = firebaseUser.Uid,
            Email = firebaseUser.Email,
            DisplayName = firebaseUser.Name,
            IsActive = true
        };

        _db.Users.Add(user);

        await _db.SaveChangesAsync(ct);

        return user;
    }
}