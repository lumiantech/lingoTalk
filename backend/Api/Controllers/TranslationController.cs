using Core.DTOs;
using Core.Interfaces;
using Microsoft.AspNetCore.Mvc;

namespace Api.Controllers;

[ApiController]
[Route("api/translation")]
public sealed class TranslationController : ControllerBase
{
    private readonly IOpenAiTranslationService _translation;

    public TranslationController(
        IOpenAiTranslationService translation)
    {
        _translation = translation;
    }

    [HttpPost("premium")]
    public async Task<ActionResult<PremiumTranslationResponse>>
        Premium(
            [FromBody] PremiumTranslationRequest request,
            CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Text))
        {
            return BadRequest(
                "Text is required.");
        }

        if (string.IsNullOrWhiteSpace(request.SourceLanguage))
        {
            return BadRequest(
                "Source language is required.");
        }

        if (string.IsNullOrWhiteSpace(request.TargetLanguage))
        {
            return BadRequest(
                "Target language is required.");
        }

        request.Context =
            request.Context
                .TakeLast(3)
                .ToList();

        var result =
            await _translation.TranslateAsync(
                request,
                ct);

        return Ok(result);
    }
}
