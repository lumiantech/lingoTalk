namespace Core.DTOs;

public sealed record MediaUploadResult(
    string PublicId,
    string Url,
    string ResourceType,
    long? SizeBytes = null,
    string? Format = null
);