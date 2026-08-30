using Core.Entities;
using Core.Options;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Infrastructure.Persistence.Seed;

public sealed class DatabaseSeeder
{
    private readonly AppDbContext _db;
    private readonly SeedOptions _options;

    public DatabaseSeeder(
        AppDbContext db,
        IOptions<SeedOptions> options)
    {
        _db = db;
        _options = options.Value;
    }

    public async Task SeedAsync(
        CancellationToken ct = default)
    {
        await SeedRolesAsync(ct);
        await SeedUsersAsync(ct);

        await _db.SaveChangesAsync(ct);
    }

    private async Task SeedRolesAsync(
        CancellationToken ct)
    {
        var existingRoles = await _db.Roles
            .Select(x => x.Name)
            .ToListAsync(ct);

        foreach (var roleName in _options.Roles)
        {
            if (existingRoles.Contains(roleName))
                continue;

            _db.Roles.Add(new Role
            {
                Name = roleName
            });
        }

        await _db.SaveChangesAsync(ct);
    }

    private async Task SeedUsersAsync(
        CancellationToken ct)
    {
        foreach (var seedUser in _options.Users)
        {

            User? user = null;

            if (!string.IsNullOrWhiteSpace(seedUser.FirebaseUid))
            {
                user = await _db.Users
                    .SingleOrDefaultAsync(
                        x => x.FirebaseUid == seedUser.FirebaseUid,
                        ct);
            }

            if (user == null &&
                !string.IsNullOrWhiteSpace(seedUser.Email))
            {
                user = await _db.Users
                    .SingleOrDefaultAsync(
                        x => x.Email == seedUser.Email,
                        ct);
            }

            if (user == null)
            {
                user = new User
                {
                    FirebaseUid = seedUser.FirebaseUid,
                    Email = seedUser.Email,
                    DisplayName = seedUser.DisplayName,
                    IsActive = true
                };

                _db.Users.Add(user);

                await _db.SaveChangesAsync(ct);
            }

            foreach (var roleName in seedUser.Roles)
            {
                var role = await _db.Roles
                    .SingleAsync(
                        x => x.Name == roleName,
                        ct);

                var exists = await _db.UserRoles
                    .AnyAsync(
                        x =>
                            x.UserId == user.Id &&
                            x.RoleId == role.Id,
                        ct);

                if (exists)
                    continue;

                _db.UserRoles.Add(new UserRole
                {
                    UserId = user.Id,
                    RoleId = role.Id
                });
            }
        }
    }
}