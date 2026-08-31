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

builder.Services.AddEndpointsApiExplorer();

builder.Services
    .AddAuthentication(options =>
    {
        options.DefaultAuthenticateScheme =
            FirebaseAuthenticationHandler.SchemeName;

        options.DefaultChallengeScheme =
            FirebaseAuthenticationHandler.SchemeName;
    })
    .AddScheme<AuthenticationSchemeOptions, FirebaseAuthenticationHandler>(
        FirebaseAuthenticationHandler.SchemeName,
        _ => { });

builder.Services.AddScoped<IClaimsTransformation, UserClaimsTransformation>();

builder.Services.AddAuthorization();

builder.Services.AddSignalR();

builder.Services.AddCors(options =>
{
    options.AddPolicy("MobileApp", policy =>
    {
        policy
            .WithOrigins(
                "http://localhost:8100",
                "http://localhost")
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
    app.Services.GetRequiredService<FirebaseInitializer>();

firebaseInitializer.Initialize();

Console.WriteLine("3. Firebase initialized");

app.UseMiddleware<ExceptionMiddleware>();

if (app.Environment.IsDevelopment())
{
    Console.WriteLine("4. Starting database initialization");

    await app.Services.InitializeDatabaseAsync();

    Console.WriteLine("5. Database initialized");
}

app.UseHttpsRedirection();

app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();
app.MapHub<TranslationHub>("/hubs/translation");

Console.WriteLine("6. Starting web server");

app.Run();