using Api.Auth;
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
builder.Services.AddSwaggerGen();

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

var app = builder.Build();



var firebaseInitializer =
    app.Services.GetRequiredService<FirebaseInitializer>();

firebaseInitializer.Initialize();

app.UseMiddleware<ExceptionMiddleware>();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();

    await app.Services.InitializeDatabaseAsync();
}

app.UseHttpsRedirection();

app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();