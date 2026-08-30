using Core.DTOs;
using Core.Interfaces;
using FirebaseAdmin.Auth;

namespace Infrastructure.Services;

public sealed class FirebaseAuthService : IFirebaseAuthService
{
    public async Task<FirebaseUserDto?> VerifyTokenAsync(
        string idToken,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(idToken))
            return null;

        try
        {
            var token = await FirebaseAuth.DefaultInstance
                .VerifyIdTokenAsync(idToken, ct);

            token.Claims.TryGetValue("email", out var email);
            token.Claims.TryGetValue("name", out var name);

            return new FirebaseUserDto
            {
                Uid = token.Uid,
                Email = email?.ToString(),
                Name = name?.ToString()
            };
        }
        catch (FirebaseAuthException)
        {
            return null;
        }
    }
}