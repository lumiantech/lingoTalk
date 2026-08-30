using Core.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Infrastructure.Persistence.Configurations;

public class UserConfiguration : IEntityTypeConfiguration<User>
{
    public void Configure(EntityTypeBuilder<User> builder)
    {
        builder.ToTable("Users");

        builder.HasKey(x => x.Id);

        builder.Property(x => x.FirebaseUid)           
            .HasMaxLength(128);

        builder.HasIndex(x => x.FirebaseUid)
            .IsUnique();

        builder.Property(x => x.Email)
            .HasMaxLength(320);

        builder.Property(x => x.DisplayName)
            .HasMaxLength(200);

        builder.Property(x => x.NativeLanguage)
            .IsRequired()
            .HasMaxLength(10);

        builder.Property(x => x.AccessTier)
            .HasConversion<string>()
            .HasMaxLength(30);

        builder.Property(x => x.CreatedAt)
            .IsRequired();
    }
}