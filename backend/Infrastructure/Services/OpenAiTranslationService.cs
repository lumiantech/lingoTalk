using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Core.DTOs;
using Core.Interfaces;
using Microsoft.Extensions.Configuration;

namespace Infrastructure.Services;

public sealed class OpenAiTranslationService : IOpenAiTranslationService
{
    private readonly HttpClient _httpClient;
    private readonly string _apiKey;
    private readonly string _model;

    private static readonly JsonSerializerOptions JsonOptions =
        new(JsonSerializerDefaults.Web);

    public OpenAiTranslationService(
        HttpClient httpClient,
        IConfiguration configuration)
    {
        _httpClient = httpClient;

        _apiKey =
            configuration["OpenAI:ApiKey"]
            ?? Environment.GetEnvironmentVariable("OPENAI_API_KEY")
            ?? throw new InvalidOperationException(
                "OpenAI API key is not configured.");

        _model =
            configuration["OpenAI:Model"]
            ?? "gpt-5.6-luna";
    }

    public async Task<PremiumTranslationResponse> TranslateAsync(
        PremiumTranslationRequest request,
        CancellationToken ct = default)
    {
        var cleanText = request.Text.Trim();

        if (string.IsNullOrWhiteSpace(cleanText))
        {
            throw new ArgumentException(
                "Translation text is required.",
                nameof(request));
        }

        if (string.IsNullOrWhiteSpace(request.SourceLanguage))
        {
            throw new ArgumentException(
                "Source language is required.",
                nameof(request));
        }

        if (string.IsNullOrWhiteSpace(request.TargetLanguage))
        {
            throw new ArgumentException(
                "Target language is required.",
                nameof(request));
        }

        var context = request.Context
            .Where(x =>
                !string.IsNullOrWhiteSpace(x.OriginalText) ||
                !string.IsNullOrWhiteSpace(x.TranslatedText))
            .TakeLast(3)
            .ToList();

        var contextText = BuildContextText(context);

        var systemPrompt = """
You are the premium live-translation engine for a real-time conversation app.

You receive:
1. PREVIOUS_CONVERSATION: up to three already completed subtitle messages.
2. CURRENT_TEXT: a short new speech-to-text segment.
3. SOURCE_LANGUAGE and TARGET_LANGUAGE.

PREVIOUS_CONVERSATION is context only.

For CURRENT_TEXT:
- Correct only highly probable speech-recognition errors when the context makes the intended wording clear.
- Preserve the speaker's meaning, tone, wording, names, numbers, product names, technical terms and intent.
- Do not rewrite merely to improve style.
- Do not invent missing information.
- If a suspected recognition error is uncertain, keep the original wording.
- Translate the corrected CURRENT_TEXT into TARGET_LANGUAGE.
- If source and target languages are the same, translatedText must equal correctedOriginalText.

Critical output rule:
- correctedOriginalText must contain ONLY the corrected CURRENT_TEXT.
- translatedText must contain ONLY the translation of that same CURRENT_TEXT.
- Never copy, repeat, summarize, concatenate or return text from PREVIOUS_CONVERSATION.
""";

        var userPrompt = $"""
SOURCE_LANGUAGE:
{request.SourceLanguage}

TARGET_LANGUAGE:
{request.TargetLanguage}

PREVIOUS_CONVERSATION:
{contextText}

CURRENT_TEXT:
{cleanText}
""";

        var payload = new
        {
            model = _model,
            input = new object[]
            {
                new
                {
                    role = "system",
                    content = systemPrompt
                },
                new
                {
                    role = "user",
                    content = userPrompt
                }
            },
            text = new
            {
                format = new
                {
                    type = "json_schema",
                    name = "premium_translation",
                    strict = true,
                    schema = new
                    {
                        type = "object",
                        properties = new
                        {
                            correctedOriginalText = new
                            {
                                type = "string"
                            },
                            translatedText = new
                            {
                                type = "string"
                            }
                        },
                        required = new[]
                        {
                            "correctedOriginalText",
                            "translatedText"
                        },
                        additionalProperties = false
                    }
                }
            },
            max_output_tokens = 160
        };

        using var httpRequest =
            new HttpRequestMessage(
                HttpMethod.Post,
                "https://api.openai.com/v1/responses");

        httpRequest.Headers.Authorization =
            new AuthenticationHeaderValue(
                "Bearer",
                _apiKey);

        httpRequest.Content =
            JsonContent.Create(payload);

        using var response =
            await _httpClient.SendAsync(
                httpRequest,
                HttpCompletionOption.ResponseHeadersRead,
                ct);

        var responseBody =
            await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"OpenAI translation failed " +
                $"({(int)response.StatusCode}): " +
                responseBody);
        }

        using var document =
            JsonDocument.Parse(responseBody);

        var outputText =
            ExtractOutputText(document.RootElement);

        if (string.IsNullOrWhiteSpace(outputText))
        {
            throw new InvalidOperationException(
                "OpenAI returned no translation text.");
        }

        var result =
            JsonSerializer.Deserialize<PremiumTranslationResponse>(
                outputText,
                JsonOptions);

        if (
            result is null ||
            string.IsNullOrWhiteSpace(
                result.CorrectedOriginalText) ||
            string.IsNullOrWhiteSpace(
                result.TranslatedText)
        )
        {
            throw new InvalidOperationException(
                "OpenAI returned an invalid translation result.");
        }

        result.CorrectedOriginalText =
            result.CorrectedOriginalText.Trim();

        result.TranslatedText =
            result.TranslatedText.Trim();

        return result;
    }

    private static string BuildContextText(
        IReadOnlyList<TranslationContextMessage> context)
    {
        if (context.Count == 0)
        {
            return "(none)";
        }

        var builder = new StringBuilder();

        for (var i = 0; i < context.Count; i++)
        {
            var item = context[i];

            builder.Append("MESSAGE ");
            builder.Append(i + 1);
            builder.AppendLine(":");

            if (!string.IsNullOrWhiteSpace(item.OriginalText))
            {
                builder.Append("Original: ");
                builder.AppendLine(item.OriginalText.Trim());
            }

            if (!string.IsNullOrWhiteSpace(item.TranslatedText))
            {
                builder.Append("Translation: ");
                builder.AppendLine(item.TranslatedText.Trim());
            }
        }

        return builder.ToString().TrimEnd();
    }

    private static string ExtractOutputText(
        JsonElement root)
    {
        if (
            !root.TryGetProperty("output", out var output) ||
            output.ValueKind != JsonValueKind.Array
        )
        {
            return "";
        }

        foreach (var outputItem in output.EnumerateArray())
        {
            if (
                !outputItem.TryGetProperty(
                    "content",
                    out var content) ||
                content.ValueKind != JsonValueKind.Array
            )
            {
                continue;
            }

            foreach (var contentItem in content.EnumerateArray())
            {
                if (
                    contentItem.TryGetProperty(
                        "type",
                        out var type) &&
                    type.GetString() == "output_text" &&
                    contentItem.TryGetProperty(
                        "text",
                        out var text)
                )
                {
                    return text.GetString() ?? "";
                }
            }
        }

        return "";
    }
}
