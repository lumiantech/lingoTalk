using CloudinaryDotNet;
using CloudinaryDotNet.Actions;
using Core.DTOs;
using Core.Enums;
using Core.Interfaces;

namespace Infrastructure.Storage;

public sealed class CloudinaryMediaStorage : IMediaStorage
{
    private readonly Cloudinary _cloudinary;

    public CloudinaryMediaStorage(Cloudinary cloudinary)
    {
        _cloudinary = cloudinary;
    }

    public async Task<MediaUploadResult> UploadAsync(
        Stream stream,
        string fileName,
        string contentType,
        string folder,
        MediaAssetType type,
        CancellationToken ct = default)
    {
        return type switch
        {
            MediaAssetType.ProfileImage or
            MediaAssetType.ChatImage
                => await UploadImageAsync(
                    stream,
                    fileName,
                    folder,
                    ct),

            MediaAssetType.ChatVideo or
            MediaAssetType.VoiceMessage
                => await UploadVideoAsync(
                    stream,
                    fileName,
                    folder,
                    ct),

            MediaAssetType.Document
                => await UploadRawAsync(
                    stream,
                    fileName,
                    folder,
                    ct),

            _ => throw new ArgumentOutOfRangeException(
                nameof(type),
                type,
                null)
        };
    }

    public async Task DeleteAsync(
        string publicId,
        MediaAssetType type,
        CancellationToken ct = default)
    {
        var resourceType = type switch
        {
            MediaAssetType.ProfileImage => ResourceType.Image,
            MediaAssetType.ChatImage => ResourceType.Image,

            MediaAssetType.ChatVideo => ResourceType.Video,
            MediaAssetType.VoiceMessage => ResourceType.Video,

            MediaAssetType.Document => ResourceType.Raw,

            _ => throw new ArgumentOutOfRangeException(
                nameof(type),
                type,
                null)
        };

        var result = await _cloudinary.DestroyAsync(
            new DeletionParams(publicId)
            {
                ResourceType = resourceType
            });

        if (result.Result is not ("ok" or "not found"))
        {
            throw new InvalidOperationException(
                $"Cloudinary delete failed: {result.Result}");
        }
    }

    private async Task<MediaUploadResult> UploadImageAsync(
        Stream stream,
        string fileName,
        string folder,
        CancellationToken ct)
    {
        var uploadParams = new ImageUploadParams
        {
            File = new FileDescription(fileName, stream),
            Folder = folder
        };

        var result = await _cloudinary.UploadAsync(
            uploadParams,
            cancellationToken: ct);

        if (result.Error is not null)
        {
            throw new InvalidOperationException(
                $"Cloudinary upload failed: {result.Error.Message}");
        }

        return new MediaUploadResult(
            result.PublicId,
            result.SecureUrl?.ToString()
                ?? result.Url?.ToString()
                ?? string.Empty,
            result.ResourceType,
            result.Bytes,
            result.Format);
    }

    private async Task<MediaUploadResult> UploadVideoAsync(
        Stream stream,
        string fileName,
        string folder,
        CancellationToken ct)
    {
        var uploadParams = new VideoUploadParams
        {
            File = new FileDescription(fileName, stream),
            Folder = folder
        };

        var result = await _cloudinary.UploadAsync(
            uploadParams,
            cancellationToken: ct);

        if (result.Error is not null)
        {
            throw new InvalidOperationException(
                $"Cloudinary upload failed: {result.Error.Message}");
        }

        return new MediaUploadResult(
            result.PublicId,
            result.SecureUrl?.ToString()
                ?? result.Url?.ToString()
                ?? string.Empty,
            result.ResourceType,
            result.Bytes,
            result.Format);
    }

    private async Task<MediaUploadResult> UploadRawAsync(
        Stream stream,
        string fileName,
        string folder,
        CancellationToken ct)
    {
        var uploadParams = new RawUploadParams
        {
            File = new FileDescription(fileName, stream),
            Folder = folder
        };

        var result = await _cloudinary.UploadAsync(
            uploadParams,
            cancellationToken: ct);

        if (result.Error is not null)
        {
            throw new InvalidOperationException(
                $"Cloudinary upload failed: {result.Error.Message}");
        }

        return new MediaUploadResult(
            result.PublicId,
            result.SecureUrl?.ToString()
                ?? result.Url?.ToString()
                ?? string.Empty,
            result.ResourceType,
            result.Bytes,
            result.Format);
    }
}