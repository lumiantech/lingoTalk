namespace Core.Interfaces;

public interface IUserContext
{
    string? UserId { get; }
    string? UserName { get; }
}