using Microsoft.AspNetCore.SignalR;

namespace Api.Hubs;

public sealed class TranslationHub : Hub
{
    public async Task JoinSession(string sessionId)
    {
        await Groups.AddToGroupAsync(
            Context.ConnectionId,
            sessionId);
    }

    public async Task LeaveSession(string sessionId)
    {
        await Groups.RemoveFromGroupAsync(
            Context.ConnectionId,
            sessionId);
    }

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
}