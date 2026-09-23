using Core.DTOs;

namespace Core.Interfaces;

public interface IOpenAiTranslationService
{
    Task<PremiumTranslationResponse> TranslateAsync(
        PremiumTranslationRequest request,
        CancellationToken ct = default);
}
