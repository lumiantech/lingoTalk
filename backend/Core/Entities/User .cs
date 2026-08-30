using Core.Enums;

namespace Core.Entities;

public class User : BaseEntity
{
    public string? FirebaseUid { get; set; }
    private string? _email;

    public string? Email
    {
        get => _email;
        set => _email = string.IsNullOrWhiteSpace(value)
            ? null
            : value.Trim().ToLowerInvariant();
    }

    public string? DisplayName { get; set; }

    public string NativeLanguage { get; set; } = "hr";

    public bool IsActive { get; set; } = true;

    public AccessTier AccessTier { get; set; } = AccessTier.Free;

    public DateTime? TrialEndsAt { get; set; }

    public DateTime? AccessUntil { get; set; }

    public int DailyTranslationLimit { get; set; } = 100;

    public ICollection<UserRole> UserRoles { get; set; } = [];

    public ICollection<Subscription> Subscriptions { get; set; } = [];
}