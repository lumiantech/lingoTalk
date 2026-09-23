namespace Core.DTOs;

public sealed class PremiumTranslationResponse
{
    public string CorrectedOriginalText { get; set; } = "";

    public string TranslatedText { get; set; } = "";
}
