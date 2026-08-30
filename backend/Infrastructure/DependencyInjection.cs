using Core.Interfaces;
using Core.Options;
using Infrastructure.Persistence;
using Infrastructure.Persistence.Seed;
using Infrastructure.Services;
using Infrastructure.Storage;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var connectionString =
            configuration.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException(
                "ConnectionStrings:DefaultConnection is missing.");

        services.AddDbContext<AppDbContext>(options =>
            options.UseNpgsql(connectionString));

        services.Configure<SeedOptions>(
            configuration.GetSection(SeedOptions.SectionName));

        services.AddScoped<DatabaseSeeder>();
        services.AddScoped<IUnitOfWork, UnitOfWork>();
        services.Configure<FirebaseOptions>(configuration.GetSection(FirebaseOptions.SectionName));

        services.AddSingleton<FirebaseInitializer>();
        services.AddScoped<IFirebaseAuthService, FirebaseAuthService>();
        services.AddScoped<IUserProvisioningService, UserProvisioningService>();
       
        
        services.Configure<CloudinaryOptions>(
            configuration.GetSection(CloudinaryOptions.SectionName));

        var cloudinaryOptions = configuration
        .GetSection(CloudinaryOptions.SectionName)
        .Get<CloudinaryOptions>()
    ?? throw new InvalidOperationException(
        "Cloudinary configuration is missing.");

        var cloudinaryAccount = new CloudinaryDotNet.Account(
            cloudinaryOptions.CloudName,
            cloudinaryOptions.ApiKey,
            cloudinaryOptions.ApiSecret);

        services.AddSingleton(new CloudinaryDotNet.Cloudinary(cloudinaryAccount));
        services.AddScoped<IMediaStorage, CloudinaryMediaStorage>();

        return services;
    }
}