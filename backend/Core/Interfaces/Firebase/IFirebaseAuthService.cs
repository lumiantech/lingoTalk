using Core.DTOs;

namespace Core.Interfaces;

public interface IFirebaseAuthService
{
    Task<FirebaseUserDto?> VerifyTokenAsync(string idToken, CancellationToken ct = default);
}