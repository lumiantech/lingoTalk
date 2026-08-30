using Core.Entities.Events;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Infrastructure.Persistence.Configurations;

public sealed class OutboxEventConfiguration
    : IEntityTypeConfiguration<OutboxEvent>
{
    public void Configure(
        EntityTypeBuilder<OutboxEvent> builder)
    {
        builder.ToTable("OutboxEvents");

        builder.HasKey(x => x.Id);

        builder.Property(x => x.Type)
            .IsRequired()
            .HasMaxLength(200);

        builder.Property(x => x.AggregateId)
            .IsRequired()
            .HasMaxLength(200);

        builder.Property(x => x.PayloadJson)
            .IsRequired()
            .HasColumnType("jsonb");

        builder.Property(x => x.Error)
            .HasMaxLength(4000);

        builder.HasIndex(x => x.ProcessedAt);

        builder.HasIndex(x => new
        {
            x.ProcessedAt,
            x.CreatedAt
        });
    }
}