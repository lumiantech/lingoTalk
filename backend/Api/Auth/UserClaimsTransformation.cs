using System.Security.Claims;
using Infrastructure.Persistence;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;

namespace Api.Auth;

public sealed class UserClaimsTransformation : IClaimsTransformation
{
    private readonly AppDbContext _db;

    public UserClaimsTransformation(AppDbContext db)
    {
        _db = db;
    }

    public async Task<ClaimsPrincipal> TransformAsync(
        ClaimsPrincipal principal)
    {
        var uid = principal.FindFirst("user_id")?.Value;

        if (string.IsNullOrWhiteSpace(uid))
            return principal;

        var identity = principal.Identity as ClaimsIdentity;

        if (identity is null)
            return principal;

        var user = await _db.Users
            .Include(x => x.UserRoles)
                .ThenInclude(x => x.Role)
            .SingleOrDefaultAsync(
                x => x.FirebaseUid == uid);

        if (user is null)
            return principal;

        foreach (var userRole in user.UserRoles)
        {
            if (!identity.HasClaim(
                    ClaimTypes.Role,
                    userRole.Role.Name))
            {
                identity.AddClaim(
                    new Claim(
                        ClaimTypes.Role,
                        userRole.Role.Name));
            }
        }

        identity.AddClaim(
            new Claim(
                "app_user_id",
                user.Id.ToString()));

        return principal;
    }
}