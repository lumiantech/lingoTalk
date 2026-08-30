using Core.Interfaces;
using Core.Options;
using Infrastructure.Persistence;
using Infrastructure.Persistence.Seed;
using Infrastructure.Services;
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
            configuration.GetConnectionString(
                "DefaultConnection")
            ?? throw new InvalidOperationException(
                "ConnectionStrings:DefaultConnection is missing.");

        services.AddDbContext<AppDbContext>(options =>
            options.UseNpgsql(connectionString));

        services.AddScoped<IUnitOfWork, UnitOfWork>();
        services.AddScoped<DatabaseSeeder>();
        services.Configure<SeedOptions>(
    configuration.GetSection(SeedOptions.SectionName));
        services.AddScoped<DatabaseSeeder>();
       

        return services;
    }
}