namespace Core.DTOs;

public sealed class FirebaseUserDto
{
    public string Uid { get; set; } = null!;

    public string? Email { get; set; }

    public string? Name { get; set; }
}