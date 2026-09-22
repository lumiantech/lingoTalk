using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

namespace Api.Hubs;

public sealed class TranslationHub : Hub
{
    private sealed record Participant(
        string SessionId,
        string Language);

    private static readonly ConcurrentDictionary<string, Participant>
        Participants = new();

    public async Task JoinSession(
        string sessionId,
        string language)
    {
        sessionId = sessionId.Trim();
        language = language.Trim();

        if (string.IsNullOrWhiteSpace(sessionId))
        {
            throw new HubException("Session ID is required.");
        }

        if (string.IsNullOrWhiteSpace(language))
        {
            throw new HubException("Language is required.");
        }

        await Groups.AddToGroupAsync(
            Context.ConnectionId,
            sessionId);

        Participants[Context.ConnectionId] =
            new Participant(
                sessionId,
                language);

        // Pošalji novom korisniku jezike ljudi
        // koji su već u sessionu.
        var existingParticipants =
            Participants
                .Where(x =>
                    x.Key != Context.ConnectionId &&
                    x.Value.SessionId == sessionId)
                .Select(x => x.Value)
                .ToList();

        foreach (var participant in existingParticipants)
        {
            await Clients.Caller.SendAsync(
                "ParticipantLanguageChanged",
                participant.Language);
        }

        // Javi postojećem korisniku koji je jezik
        // upravo spojenog sudionika.
        await Clients
            .OthersInGroup(sessionId)
            .SendAsync(
                "ParticipantLanguageChanged",
                language);
    }

    public async Task UpdateLanguage(
        string sessionId,
        string language)
    {
        sessionId = sessionId.Trim();
        language = language.Trim();

        if (Participants.TryGetValue(
                Context.ConnectionId,
                out var participant))
        {
            Participants[Context.ConnectionId] =
                participant with
                {
                    Language = language
                };
        }

        await Clients
            .OthersInGroup(sessionId)
            .SendAsync(
                "ParticipantLanguageChanged",
                language);
    }

    public async Task LeaveSession(
        string sessionId)
    {
        Participants.TryRemove(
            Context.ConnectionId,
            out _);

        await Groups.RemoveFromGroupAsync(
            Context.ConnectionId,
            sessionId);

        await Clients
            .Group(sessionId)
            .SendAsync(
                "ParticipantLeft");
    }

    public async Task SendSubtitle(
        string sessionId,
        SubtitleMessage message)
    {
        await Clients
            .OthersInGroup(sessionId)
            .SendAsync(
                "SubtitleReceived",
                message);
    }

    // Ostavimo postojeći text chat.
    public async Task SendText(
        string sessionId,
        string text)
    {
        await Clients
            .OthersInGroup(sessionId)
            .SendAsync(
                "TextReceived",
                text);
    }

    public async Task SendWebRtcOffer(
        string sessionId,
        string offer)
    {
        await Clients
            .OthersInGroup(sessionId)
            .SendAsync(
                "WebRtcOfferReceived",
                offer);
    }

    public async Task SendWebRtcAnswer(
        string sessionId,
        string answer)
    {
        await Clients
            .OthersInGroup(sessionId)
            .SendAsync(
                "WebRtcAnswerReceived",
                answer);
    }

    public async Task SendIceCandidate(
        string sessionId,
        string candidate)
    {
        await Clients
            .OthersInGroup(sessionId)
            .SendAsync(
                "IceCandidateReceived",
                candidate);
    }

    public override async Task OnDisconnectedAsync(
        Exception? exception)
    {
        if (Participants.TryRemove(
                Context.ConnectionId,
                out var participant))
        {
            await Clients
                .Group(participant.SessionId)
                .SendAsync(
                    "ParticipantLeft");
        }

        await base.OnDisconnectedAsync(exception);
    }
}

public sealed class SubtitleMessage
{
    public string SegmentId { get; set; } = "";

    public string OriginalText { get; set; } = "";

    public string TranslatedText { get; set; } = "";

    public string SourceLanguage { get; set; } = "";

    public string TargetLanguage { get; set; } = "";

    public bool IsFinal { get; set; }
}