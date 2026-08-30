
namespace Core.Entities.Events;

public sealed class OutboxEvent : BaseEntity
{
    public string Type { get; set; } = null!;

    public string AggregateId { get; set; } = null!;

    public string PayloadJson { get; set; } = null!;

    public DateTime? ProcessedAt { get; set; }

    public int RetryCount { get; set; }

    public string? Error { get; set; }
}