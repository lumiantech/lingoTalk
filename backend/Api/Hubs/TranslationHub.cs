using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

namespace Api.Hubs;

public sealed class TranslationHub : Hub
{
    private sealed record Participant(
        string SessionId,
        string Language,
        string Platform,
        bool LocalTranslation);

    private static readonly ConcurrentDictionary<string, Participant> Participants = new();

    public async Task JoinSession(
        string sessionId,
        string language,
        string platform,
        bool localTranslation)
    {
        sessionId = sessionId.Trim();
        language = language.Trim();

        platform = string.IsNullOrWhiteSpace(platform)
            ? "web"
            : platform.Trim().ToLowerInvariant();

        if (string.IsNullOrWhiteSpace(sessionId))
            throw new HubException("Session ID is required.");

        if (string.IsNullOrWhiteSpace(language))
            throw new HubException("Language is required.");

        await Groups.AddToGroupAsync(Context.ConnectionId, sessionId);

        var participant = new Participant(sessionId, language, platform, localTranslation);
        Participants[Context.ConnectionId] = participant;

        var existingParticipants = Participants
            .Where(x => x.Key != Context.ConnectionId && x.Value.SessionId == sessionId)
            .Select(x => x.Value)
            .ToList();

        foreach (var existingParticipant in existingParticipants)
            await SendParticipantChanged(Clients.Caller, existingParticipant);

        await SendParticipantChanged(Clients.OthersInGroup(sessionId), participant);
    }

    public async Task UpdateLanguage(string sessionId, string language)
    {
        sessionId = sessionId.Trim();
        language = language.Trim();

        if (string.IsNullOrWhiteSpace(sessionId)) return;
        if (string.IsNullOrWhiteSpace(language)) return;

        if (!Participants.TryGetValue(Context.ConnectionId, out var participant))
            return;

        var updated = participant with { Language = language };
        Participants[Context.ConnectionId] = updated;

        await SendParticipantChanged(Clients.OthersInGroup(sessionId), updated);
    }

    public async Task LeaveSession(string sessionId)
    {
        sessionId = sessionId.Trim();
        Participants.TryRemove(Context.ConnectionId, out _);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, sessionId);
        await Clients.OthersInGroup(sessionId).SendAsync("ParticipantLeft");
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Participants.TryRemove(Context.ConnectionId, out var participant))
            await Clients.OthersInGroup(participant.SessionId).SendAsync("ParticipantLeft");

        await base.OnDisconnectedAsync(exception);
    }

    public async Task SendSubtitle(string sessionId, SubtitleMessage message)
    {
        sessionId = sessionId.Trim();
        if (string.IsNullOrWhiteSpace(sessionId)) return;
        if (string.IsNullOrWhiteSpace(message.SegmentId)) return;

        message.Stage = "local";
        message.RequestAi = false;

        await Clients.OthersInGroup(sessionId)
            .SendAsync("SubtitleReceived", message);
    }

    // Diagnostic ACK: receiver sends this only after the subtitle has had
    // two browser paint opportunities. It never affects subtitle delivery.
    public async Task SendSubtitleRenderedAck(string sessionId, SubtitleRenderedAck ack)
    {
        sessionId = sessionId.Trim();
        if (string.IsNullOrWhiteSpace(sessionId)) return;
        if (string.IsNullOrWhiteSpace(ack.SegmentId)) return;

        await Clients.OthersInGroup(sessionId)
            .SendAsync("SubtitleRenderedAckReceived", ack);
    }

    public async Task SendText(string sessionId, string text)
    {
        await Clients.OthersInGroup(sessionId).SendAsync("TextReceived", text);
    }

    public async Task SendWebRtcOffer(string sessionId, string offer)
    {
        await Clients.OthersInGroup(sessionId).SendAsync("WebRtcOfferReceived", offer);
    }

    public async Task SendWebRtcAnswer(string sessionId, string answer)
    {
        await Clients.OthersInGroup(sessionId).SendAsync("WebRtcAnswerReceived", answer);
    }

    public async Task SendIceCandidate(string sessionId, string candidate)
    {
        await Clients.OthersInGroup(sessionId).SendAsync("IceCandidateReceived", candidate);
    }

    private static Task SendParticipantChanged(IClientProxy client, Participant participant)
    {
        return client.SendAsync("ParticipantChanged", new
        {
            language = participant.Language,
            platform = participant.Platform,
            localTranslation = participant.LocalTranslation
        });
    }
}

public sealed class SubtitleMessage
{
    public string SegmentId { get; set; } = "";
    public long SenderSentAt { get; set; }
    public string OriginalText { get; set; } = "";
    public string TranslatedText { get; set; } = "";
    public string SourceLanguage { get; set; } = "";
    public string TargetLanguage { get; set; } = "";
    public string Stage { get; set; } = "local";
    public bool RequestAi { get; set; }
}

public sealed class SubtitleRenderedAck
{
    public string SegmentId { get; set; } = "";
    public long SenderSentAt { get; set; }
    public long ReceiverReceivedAt { get; set; }
    public long ReceiverRenderedAt { get; set; }
}
