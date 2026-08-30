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
}