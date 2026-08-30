using Core.Options;
using FirebaseAdmin;
using Google.Apis.Auth.OAuth2;
using Microsoft.Extensions.Options;

namespace Infrastructure.Services;

public sealed class FirebaseInitializer
{
    private readonly FirebaseOptions _options;

    public FirebaseInitializer(IOptions<FirebaseOptions> options)
    {
        _options = options.Value;
    }

    public FirebaseApp Initialize()
    {
        if (FirebaseApp.DefaultInstance is not null)
        {
            return FirebaseApp.DefaultInstance;
        }

        var credential = GoogleCredential.FromFile(_options.CredentialPath);

        return FirebaseApp.Create(new AppOptions
        {
            Credential = credential,
            ProjectId = _options.ProjectId
        });
    }
}