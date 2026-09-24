using System.Threading.Channels;
using Core.DTOs;
using Core.Interfaces;
using Microsoft.AspNetCore.SignalR;

namespace Api.Hubs;

public sealed record AiTranslationJob(
    string SessionId,
    string SegmentId,
    string OriginalText,
    string SourceLanguage,
    string TargetLanguage,
    IReadOnlyList<TranslationContextMessage> Context);

public sealed class AiTranslationDispatcher : BackgroundService
{
    private readonly Channel<AiTranslationJob> _jobs =
        Channel.CreateUnbounded<AiTranslationJob>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IHubContext<TranslationHub> _hubContext;
    private readonly ILogger<AiTranslationDispatcher> _logger;
    private readonly SemaphoreSlim _parallelism = new(4, 4);

    public AiTranslationDispatcher(
        IServiceScopeFactory scopeFactory,
        IHubContext<TranslationHub> hubContext,
        ILogger<AiTranslationDispatcher> logger)
    {
        _scopeFactory = scopeFactory;
        _hubContext = hubContext;
        _logger = logger;
    }

    public void Enqueue(AiTranslationJob job)
    {
        if (!_jobs.Writer.TryWrite(job))
            _logger.LogWarning("Could not queue AI translation for {SegmentId}", job.SegmentId);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var job in _jobs.Reader.ReadAllAsync(stoppingToken))
        {
            await _parallelism.WaitAsync(stoppingToken);

            _ = ProcessAsync(job, stoppingToken).ContinueWith(
                _ => _parallelism.Release(),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
    }

    private async Task ProcessAsync(AiTranslationJob job, CancellationToken ct)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var translator = scope.ServiceProvider.GetRequiredService<IOpenAiTranslationService>();

            var request = new PremiumTranslationRequest
            {
                Text = job.OriginalText,
                SourceLanguage = job.SourceLanguage,
                TargetLanguage = job.TargetLanguage,
                Context = job.Context
                    .Select(x => new TranslationContextMessage
                    {
                        OriginalText = x.OriginalText,
                        TranslatedText = x.TranslatedText
                    })
                    .ToList()
            };

            var result = await translator.TranslateAsync(request, ct);

            var aiMessage = new SubtitleMessage
            {
                SegmentId = job.SegmentId,
                OriginalText = result.CorrectedOriginalText,
                TranslatedText = result.TranslatedText,
                SourceLanguage = job.SourceLanguage,
                TargetLanguage = job.TargetLanguage,
                Stage = "ai",
                RequestAi = false
            };

            // Group includes sender + receiver, so both get the AI line.
            await _hubContext.Clients.Group(job.SessionId)
                .SendAsync("AiSubtitleReceived", aiMessage, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "AI translation failed for {SegmentId}", job.SegmentId);
        }
    }
}
