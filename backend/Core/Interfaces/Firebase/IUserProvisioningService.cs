using Core.DTOs;
using Core.Entities;

namespace Core.Interfaces;

public interface IUserProvisioningService
{
    Task<User> GetOrCreateAsync(
        FirebaseUserDto firebaseUser,
        CancellationToken ct = default);
}