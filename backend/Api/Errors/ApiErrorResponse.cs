namespace Api.Errors;

public sealed record ApiErrorResponse(
    int StatusCode,
    string Message,
    string? Details = null,
    string? ErrorCode = null,
    IDictionary<string, string[]>? Errors = null,
    string? CorrelationId = null
);