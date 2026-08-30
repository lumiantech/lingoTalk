using System.Net;
using System.Text.Json;
using Api.Errors;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Serilog;

namespace Api.Middleware;

public sealed class ExceptionMiddleware
{
    private readonly IHostEnvironment _env;
    private readonly RequestDelegate _next;

    private readonly Serilog.ILogger _log =
        Log.ForContext<ExceptionMiddleware>();

    public ExceptionMiddleware(
        IHostEnvironment env,
        RequestDelegate next)
    {
        _env = env;
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (Exception ex)
        {
            await HandleExceptionAsync(context, ex);
        }
    }

    private Task HandleExceptionAsync(
        HttpContext context,
        Exception ex)
    {
        var status =
            (int)HttpStatusCode.InternalServerError;

        var message =
            "An unexpected error occurred.";

        string? errorCode = "internal_error";

        IDictionary<string, string[]>? errors = null;

        var correlationId =
            context.TraceIdentifier;

        var userId =
            context.User?.Identity?.IsAuthenticated == true
                ? context.User.FindFirst("user_id")?.Value
                    ?? context.User.FindFirst("sub")?.Value
                : null;

        if (ex is DbUpdateException dbEx)
        {
            var baseEx =
                dbEx.InnerException ?? dbEx;

            if (baseEx is PostgresException pgEx)
            {
                MapPostgres(
                    pgEx,
                    ref status,
                    ref message,
                    ref errorCode);
            }
            else
            {
                status =
                    (int)HttpStatusCode.Conflict;

                message =
                    "A data update error occurred.";

                errorCode =
                    "db_update_error";
            }
        }
        else if (ex is PostgresException pgEx)
        {
            MapPostgres(
                pgEx,
                ref status,
                ref message,
                ref errorCode);
        }

        _log
            .ForContext(
                "CorrelationId",
                correlationId)
            .ForContext(
                "UserId",
                userId ?? "anonymous")
            .ForContext(
                "RequestPath",
                context.Request.Path)
            .ForContext(
                "Method",
                context.Request.Method)
            .ForContext(
                "QueryString",
                context.Request.QueryString.Value)
            .ForContext(
                "ClientIP",
                context.Connection
                    .RemoteIpAddress?
                    .ToString())
            .ForContext(
                "UserAgent",
                context.Request.Headers
                    .UserAgent
                    .ToString())
            .ForContext(
                "StatusCode",
                status)
            .Error(
                ex,
                "Unhandled exception {CorrelationId} mapped to {StatusCode} ({ErrorCode})",
                correlationId,
                status,
                errorCode);

        if (status ==
            (int)HttpStatusCode.ServiceUnavailable)
        {
            context.Response.Headers.RetryAfter = "5";
        }

        context.Response.ContentType =
            "application/json";

        context.Response.StatusCode =
            status;

        var payload =
            new ApiErrorResponse(
                StatusCode: status,
                Message: _env.IsDevelopment()
                    ? ex.Message
                    : message,
                Details: _env.IsDevelopment()
                    ? ex.ToString()
                    : null,
                ErrorCode: errorCode,
                Errors: errors,
                CorrelationId: correlationId);

        var json =
            JsonSerializer.Serialize(
                payload,
                new JsonSerializerOptions
                {
                    PropertyNamingPolicy =
                        JsonNamingPolicy.CamelCase
                });

        return context.Response.WriteAsync(json);
    }

    private static void MapPostgres(
        PostgresException ex,
        ref int status,
        ref string message,
        ref string? errorCode)
    {
        switch (ex.SqlState)
        {
            case PostgresErrorCodes.UniqueViolation:
                status =
                    (int)HttpStatusCode.Conflict;

                message =
                    "A record with the same unique value already exists.";

                errorCode =
                    "unique_violation";

                break;

            case PostgresErrorCodes.ForeignKeyViolation:
                status =
                    (int)HttpStatusCode.Conflict;

                message =
                    "Operation violates a foreign key constraint.";

                errorCode =
                    "foreign_key_violation";

                break;

            case PostgresErrorCodes.NotNullViolation:
                status =
                    (int)HttpStatusCode.BadRequest;

                message =
                    "A required value is missing.";

                errorCode =
                    "not_null_violation";

                break;

            case PostgresErrorCodes.CheckViolation:
                status =
                    (int)HttpStatusCode.BadRequest;

                message =
                    "Data violates a database constraint.";

                errorCode =
                    "check_violation";

                break;

            case PostgresErrorCodes.DeadlockDetected:
            case PostgresErrorCodes.SerializationFailure:
                status =
                    (int)HttpStatusCode.ServiceUnavailable;

                message =
                    "A transient database error occurred. Please retry.";

                errorCode =
                    "transient_db_error";

                break;

            default:
                status =
                    (int)HttpStatusCode.InternalServerError;

                message =
                    "A database error occurred.";

                errorCode =
                    $"pg_{ex.SqlState}";

                break;
        }
    }
}