using System.Security.Claims;
using System.Text.Encodings.Web;
using Core.Interfaces;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Api.Auth;

public sealed class FirebaseAuthenticationHandler
    : AuthenticationHandler<AuthenticationSchemeOptions>
{
    public const string SchemeName = "Firebase";

    private readonly IFirebaseAuthService _firebaseAuth;

    public FirebaseAuthenticationHandler(
        IOptionsMonitor<AuthenticationSchemeOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder,
        IFirebaseAuthService firebaseAuth)
        : base(options, logger, encoder)
    {
        _firebaseAuth = firebaseAuth;
    }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var authorization = Request.Headers.Authorization.ToString();

        if (string.IsNullOrWhiteSpace(authorization))
            return AuthenticateResult.NoResult();

        if (!authorization.StartsWith(
                "Bearer ",
                StringComparison.OrdinalIgnoreCase))
        {
            return AuthenticateResult.NoResult();
        }

        var idToken = authorization["Bearer ".Length..].Trim();

        if (string.IsNullOrWhiteSpace(idToken))
            return AuthenticateResult.Fail("Missing Firebase ID token.");

        var firebaseUser =
            await _firebaseAuth.VerifyTokenAsync(
                idToken,
                Context.RequestAborted);

        if (firebaseUser is null)
            return AuthenticateResult.Fail("Invalid Firebase ID token.");

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, firebaseUser.Uid),
            new("user_id", firebaseUser.Uid),
            new("sub", firebaseUser.Uid)
        };

        if (!string.IsNullOrWhiteSpace(firebaseUser.Email))
        {
            claims.Add(
                new Claim(
                    ClaimTypes.Email,
                    firebaseUser.Email));

            claims.Add(
                new Claim(
                    "email",
                    firebaseUser.Email));
        }

        if (!string.IsNullOrWhiteSpace(firebaseUser.Name))
        {
            claims.Add(
                new Claim(
                    ClaimTypes.Name,
                    firebaseUser.Name));
        }

        var identity = new ClaimsIdentity(
            claims,
            SchemeName);

        var principal = new ClaimsPrincipal(identity);

        var ticket = new AuthenticationTicket(
            principal,
            SchemeName);

        return AuthenticateResult.Success(ticket);
    }
}