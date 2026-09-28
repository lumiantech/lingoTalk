using Api.Auth;
using Api.Hubs;
using Api.Middleware;
using Api.Services;
using Core.Interfaces;
using Infrastructure;
using Infrastructure.Persistence;
using Infrastructure.Services;
using Microsoft.AspNetCore.Authentication;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseSerilog((context, configuration) =>
{
    configuration
        .ReadFrom.Configuration(context.Configuration)
        .Enrich.FromLogContext()
        .WriteTo.Console();
});

builder.Services.AddControllers();

builder.Services.AddHttpContextAccessor();

builder.Services.AddScoped<IUserContext, UserContext>();

builder.Services.AddInfrastructure(
    builder.Configuration);

/*
 * Premium OpenAI translation.
 *
 * HttpClient is created by IHttpClientFactory.
 * The API key remains on the .NET server and is
 * never shipped to Angular/Android.
 */
builder.Services.AddHttpClient<
    IOpenAiTranslationService,
    OpenAiTranslationService>();

builder.Services.AddEndpointsApiExplorer();

builder.Services
    .AddAuthentication(options =>
    {
        options.DefaultAuthenticateScheme =
            FirebaseAuthenticationHandler.SchemeName;

        options.DefaultChallengeScheme =
            FirebaseAuthenticationHandler.SchemeName;
    })
    .AddScheme<
        AuthenticationSchemeOptions,
        FirebaseAuthenticationHandler>(
            FirebaseAuthenticationHandler.SchemeName,
            _ => { });

builder.Services.AddScoped<
    IClaimsTransformation,
    UserClaimsTransformation>();

builder.Services.AddAuthorization();

builder.Services.AddSignalR();

// OpenAI translation jobs run outside the Hub invocation,
// so LOCAL subtitles are never blocked by OpenAI.
builder.Services.AddSingleton<AiTranslationDispatcher>();
builder.Services.AddHostedService<AiTranslationDispatcher>(sp =>
    sp.GetRequiredService<AiTranslationDispatcher>());

builder.Services.AddCors(options =>
{
    options.AddPolicy("MobileApp", policy =>
    {
        policy
            .WithOrigins(
                "http://localhost:8100",
                "https://localhost:8100",
                "http://localhost",
                "https://localhost",
                "http://192.168.100.12:8100",
                "https://192.168.100.12:8100")
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials();
    });
});

var app = builder.Build();

Console.WriteLine("1. App built");

app.UseCors("MobileApp");

Console.WriteLine("2. Starting Firebase");

var firebaseInitializer =
    app.Services.GetRequiredService<
        FirebaseInitializer>();

firebaseInitializer.Initialize();

Console.WriteLine("3. Firebase initialized");

app.UseMiddleware<ExceptionMiddleware>();

if (app.Environment.IsDevelopment())
{
    Console.WriteLine(
        "4. Starting database initialization");

    await app.Services.InitializeDatabaseAsync();

    Console.WriteLine(
        "5. Database initialized");
}

// app.UseHttpsRedirection();

app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.MapHub<TranslationHub>(
    "/hubs/translation");

Console.WriteLine(
    "6. Starting web server");

app.Run();
