namespace Core.DTOs;

public sealed class PremiumTranslationRequest
{
    public string Text { get; set; } = "";

    public string SourceLanguage { get; set; } = "";

    public string TargetLanguage { get; set; } = "";

    public List<TranslationContextMessage> Context { get; set; } = [];
}

public sealed class TranslationContextMessage
{
    public string OriginalText { get; set; } = "";

    public string TranslatedText { get; set; } = "";
}
