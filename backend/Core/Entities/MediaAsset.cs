namespace Core.Entities
{
    public class MediaAsset : BaseEntity
    {
        public Guid OwnerUserId { get; set; }

        public Guid? ConversationId { get; set; }

        public string PublicId { get; set; } = null!;

        public string Url { get; set; } = null!;

        public string ResourceType { get; set; } = null!;
        // image, video, raw

        public string? MimeType { get; set; }

        public long? SizeBytes { get; set; }

        public string? OriginalFileName { get; set; }

        public MediaAssetType Type { get; set; }
    }
}