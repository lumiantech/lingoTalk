using Core.DTOs;
using Core.Enums;

namespace Core.Interfaces;

public interface IMediaStorage
{
    Task<MediaUploadResult> UploadAsync(
        Stream stream,
        string fileName,
        string contentType,
        string folder,
        MediaAssetType type,
        CancellationToken ct = default);

    Task DeleteAsync(
        string publicId,
        MediaAssetType type,
        CancellationToken ct = default);
}