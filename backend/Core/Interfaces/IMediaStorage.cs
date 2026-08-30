namespace Core.Interfaces;

public interface IMediaStorage
{
    Task<MediaUploadResult> UploadAsync(
        Stream stream,
        string fileName,
        string contentType,
        string folder,
        CancellationToken ct = default);

    Task DeleteAsync(
        string publicId,
        CancellationToken ct = default);
}

public class MediaUploadResult
{
}