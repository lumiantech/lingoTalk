using Core.DTOs;
using Core.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Api.Controllers;

[ApiController]
[Route("api/auth")]
public sealed class AuthController : ControllerBase
{
    private readonly IUserProvisioningService _userProvisioning;

    public AuthController(
        IUserProvisioningService userProvisioning)
    {
        _userProvisioning = userProvisioning;
    }

    [Authorize]
    [HttpGet("me")]
    public async Task<IActionResult> Me(
        CancellationToken ct)
    {
        var firebaseUser = new FirebaseUserDto
        {
            Uid = User.FindFirst("user_id")?.Value
                ?? throw new UnauthorizedAccessException(),

            Email = User.FindFirst("email")?.Value,

            Name = User.Identity?.Name
        };

        var user = await _userProvisioning
            .GetOrCreateAsync(firebaseUser, ct);

        return Ok(new
        {
            user.Id,
            user.FirebaseUid,
            user.Email,
            user.DisplayName,
            user.IsActive,
            user.AccessTier
        });
    }
}