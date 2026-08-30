using Core.Enums;

namespace Core.Entities;

public class Subscription : BaseEntity
{
    public Guid UserId { get; set; }

    public User User { get; set; } = null!;

    public string Provider { get; set; } = "GooglePlay";

    public string? ProductId { get; set; }

    public string? PurchaseToken { get; set; }

    public SubscriptionStatus Status { get; set; } =
        SubscriptionStatus.None;

    public DateTime? ValidUntil { get; set; }

    public DateTime? LastVerifiedAt { get; set; }
}