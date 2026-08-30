using Core.Interfaces;

namespace Api.Services;

public sealed class UserContext : IUserContext
{
    private readonly IHttpContextAccessor _httpContextAccessor;

    public UserContext(
        IHttpContextAccessor httpContextAccessor)
    {
        _httpContextAccessor = httpContextAccessor;
    }

    public string? UserId =>
        _httpContextAccessor.HttpContext?
            .User?
            .FindFirst("user_id")?
            .Value
        ?? _httpContextAccessor.HttpContext?
            .User?
            .FindFirst("sub")?
            .Value;

    public string? UserName =>
        _httpContextAccessor.HttpContext?
            .User?
            .Identity?
            .Name
        ?? _httpContextAccessor.HttpContext?
            .User?
            .FindFirst("email")?
            .Value;
}