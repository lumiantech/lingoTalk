namespace Core.Options;

public sealed class CloudinaryOptions
{
    public const string SectionName = "Cloudinary";

    public string CloudName { get; set; } = null!;

    public string ApiKey { get; set; } = null!;

    public string ApiSecret { get; set; } = null!;
}