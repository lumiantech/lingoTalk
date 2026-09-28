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

    // ============================================================
    // SESSION / PARTICIPANTS
    // ============================================================

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

        await Groups.AddToGroupAsync(
            Context.ConnectionId,
            sessionId);

        var participant = new Participant(
            sessionId,
            language,
            platform,
            localTranslation);

        Participants[Context.ConnectionId] = participant;

        /*
         * Tell the new participant about everybody who is
         * already in the session.
         */
        var existingParticipants = Participants
            .Where(x =>
                x.Key != Context.ConnectionId &&
                x.Value.SessionId == sessionId)
            .Select(x => x.Value)
            .ToList();

        foreach (var existingParticipant in existingParticipants)
        {
            await SendParticipantChanged(
                Clients.Caller,
                existingParticipant);
        }

        /*
         * Tell everybody else about the new participant.
         */
        await SendParticipantChanged(
            Clients.OthersInGroup(sessionId),
            participant);
    }

    public async Task UpdateLanguage(
        string sessionId,
        string language)
    {
        sessionId = sessionId.Trim();
        language = language.Trim();

        if (string.IsNullOrWhiteSpace(sessionId))
            return;

        if (string.IsNullOrWhiteSpace(language))
            return;

        if (!Participants.TryGetValue(
                Context.ConnectionId,
                out var participant))
        {
            return;
        }

        var updated = participant with
        {
            Language = language
        };

        Participants[Context.ConnectionId] = updated;

        await SendParticipantChanged(
            Clients.OthersInGroup(sessionId),
            updated);
    }

    public async Task LeaveSession(string sessionId)
    {
        sessionId = sessionId.Trim();

        Participants.TryRemove(
            Context.ConnectionId,
            out _);

        await Groups.RemoveFromGroupAsync(
            Context.ConnectionId,
            sessionId);

        await Clients
            .OthersInGroup(sessionId)
            .SendAsync("ParticipantLeft");
    }

    public override async Task OnDisconnectedAsync(
        Exception? exception)
    {
        if (Participants.TryRemove(
                Context.ConnectionId,
                out var participant))
        {
            await Clients
                .OthersInGroup(participant.SessionId)
                .SendAsync("ParticipantLeft");
        }

        await base.OnDisconnectedAsync(exception);
    }

    // ============================================================
    // SUBTITLES
    // ============================================================

    public async Task SendSubtitle(
        string sessionId,
        SubtitleMessage message)
    {
        sessionId = sessionId.Trim();

        if (string.IsNullOrWhiteSpace(sessionId))
            return;

        if (string.IsNullOrWhiteSpace(message.SegmentId))
            return;

        /*
         * User-to-user translation is now LOCAL.
         *
         * Normal mobile -> mobile:
         *
         *   sender:
         *      Sherpa STT
         *          ↓
         *      originalText
         *
         *   SignalR:
         *      transports originalText
         *
         *   receiver:
         *      ML Kit translates into receiver's selected language.
         *
         *
         * Temporary browser test fallback:
         *
         * If the receiver has no local translation capability,
         * the Android sender may put its locally translated text
         * into translatedText before calling this method.
         *
         * The Hub does NOT translate anything.
         */

        message.Stage = "local";

        /*
         * OpenAI translation is intentionally disabled for
         * user-to-user conversations.
         */
        message.RequestAi = false;

        await Clients
            .OthersInGroup(sessionId)
            .SendAsync(
                "SubtitleReceived",
                message);
    }

    // ============================================================
    // MANUAL TEXT CHAT
    // ============================================================

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

    // ============================================================
    // WEBRTC SIGNALING
    // ============================================================

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

    // ============================================================
    // PARTICIPANT CAPABILITIES
    // ============================================================

    private static Task SendParticipantChanged(
        IClientProxy client,
        Participant participant)
    {
        return client.SendAsync(
            "ParticipantChanged",
            new
            {
                language = participant.Language,
                platform = participant.Platform,
                localTranslation = participant.LocalTranslation
            });
    }
}

// ================================================================
// SUBTITLE DTO
// ================================================================

public sealed class SubtitleMessage
{
    public string SegmentId { get; set; } = "";

    public string OriginalText { get; set; } = "";

    /*
     * Mobile -> mobile:
     * normally empty when sent by speaker.
     * Receiver translates OriginalText locally.
     *
     * Android -> browser temporary test:
     * Android sender may populate this because the browser currently
     * has no local ML Kit translator.
     */
    public string TranslatedText { get; set; } = "";

    public string SourceLanguage { get; set; } = "";

    public string TargetLanguage { get; set; } = "";

    public string Stage { get; set; } = "local";

    /*
     * Kept temporarily for frontend DTO compatibility.
     * Hub forces this to false.
     *
     * Once the old AI translation frontend code is removed,
     * this property can also be deleted.
     */
    public bool RequestAi { get; set; }
}