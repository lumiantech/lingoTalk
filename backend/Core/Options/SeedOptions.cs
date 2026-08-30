namespace Core.Options;

public sealed class SeedOptions
{
    public const string SectionName = "Seed";

    public List<string> Roles { get; set; } = [];

    public List<SeedUserOptions> Users { get; set; } = [];
}

public sealed class SeedUserOptions
{
    public string? FirebaseUid { get; set; }

    public string? Email { get; set; }

    public string? DisplayName { get; set; }

    public List<string> Roles { get; set; } = [];
}