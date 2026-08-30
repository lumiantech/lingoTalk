namespace Core.Options;

public sealed class FirebaseOptions
{
    public const string SectionName = "Firebase";

    public string ProjectId { get; set; } = null!;

    public string CredentialPath { get; set; } = null!;
}