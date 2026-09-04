/**
 * The shared redirect_uri policy (#2227). Both registration paths (DCR through
 * the SDK clients store and the settings UI through createOAuthClient) used to
 * carry their own copy of it and disagreed in both directions: DCR refused every
 * single-label private-use scheme, the settings route accepted
 * javascript://localhost/…. These cases pin the one policy they now share.
 */
import { describe, it, expect } from 'vitest';
import { classifyRedirectUri, redirectUriMatches, type RedirectUriVerdict } from '../../../src/nest/oauth/oauth.helpers';

describe('classifyRedirectUri', () => {
  const cases: Array<[string, RedirectUriVerdict]> = [
    // https and loopback http
    ['https://a.example.com/cb', 'ok'],
    ['https://a.example.com:8443/cb?x=1#f', 'ok'],
    ['http://localhost:8080/cb', 'ok'],
    ['http://127.0.0.1/cb', 'ok'],
    ['http://[::1]/cb', 'ok'],
    ['http://[::1]:8080/oauth/callback', 'ok'],
    ['http://evil.example.com/cb', 'not_allowed'],
    ['http://127.0.0.1.evil.com/cb', 'not_allowed'],

    // private-use schemes, with and without the reverse-domain form
    ['com.example.app:/oauth2redirect', 'ok'],
    ['workbuddy://workbuddy/mcp/connector%3A/oauth/callback', 'ok'],
    ['myapp://cb', 'ok'],
    ['msauth://com.x.y/abc', 'ok'],

    // dangerous schemes, including the ones a localhost host used to smuggle past
    // the settings route's hostname exemption
    ['javascript:alert(1)', 'dangerous'],
    ['javascript://localhost/%0aalert(1)', 'dangerous'],
    ['blob://localhost/x', 'dangerous'],
    ['about://localhost/x', 'dangerous'],
    ['data:text/html,<script>alert(1)</script>', 'dangerous'],
    ['vbscript:msgbox(1)', 'dangerous'],
    ['file:///etc/passwd', 'dangerous'],
    ['view-source:https://x', 'dangerous'],
    ['filesystem:https://x/temporary/y', 'dangerous'],
    ['jar:https://x!/y', 'dangerous'],
    ['resource://x/y', 'dangerous'],
    ['chrome://settings', 'dangerous'],
    ['chrome-extension://abc/page.html', 'dangerous'],
    ['chrome-untrusted://x/y', 'dangerous'],
    ['moz-extension://a/b', 'dangerous'],
    ['safari-extension://a/b', 'dangerous'],
    ['android-app://com.x.y/https/host/path', 'dangerous'],
    ['intent://x#Intent;S.browser_fallback_url=https%3A%2F%2Fevil.test;end', 'dangerous'],
    // ms-msdt is Follina; the prefix rule covers the rest of the Windows handlers
    ['ms-msdt:/id PCWDiagnostic', 'dangerous'],
    ['ms-browser-extension://a/b', 'dangerous'],
    ['ms-settings:windowsupdate', 'dangerous'],
    ['ms-officecmd://x', 'dangerous'],

    // transports that are not browser navigations
    ['ws://localhost/cb', 'not_allowed'],
    ['wss://localhost/cb', 'not_allowed'],
    ['ftp://localhost/x', 'not_allowed'],
    ['ftps://localhost/x', 'not_allowed'],
    ['mailto:me@example.com', 'not_allowed'],
    ['tel:+15550000', 'not_allowed'],
    ['sms:+15550000', 'not_allowed'],
    ['urn:ietf:wg:oauth:2.0:oob', 'not_allowed'],

    // malformed
    ['not a url', 'malformed'],
    ['', 'malformed'],
    ['/relative/cb', 'malformed'],
  ];

  it.each(cases)('RURI-001: %s → %s', (uri, expected) => {
    expect(classifyRedirectUri(uri)).toBe(expected);
  });

  it('RURI-002: decides on the parsed protocol, so case and whitespace tricks normalise into the deny-list', () => {
    for (const uri of ['JavaScript:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)', 'JAVASCRIPT:alert(1)']) {
      expect(classifyRedirectUri(uri)).toBe('dangerous');
    }
  });

  it('RURI-004: OS protocol handlers are denied whether or not they carry the ms- prefix', () => {
    // The prefix rule catches the ms-* namespace; these four are the well-known
    // siblings that sit outside it and would otherwise read as private-use.
    for (const uri of ['search-ms:query=x', 'shell:startup', 'microsoft-edge:https://evil.test', 'itms-services://?url=x']) {
      expect(classifyRedirectUri(uri)).toBe('dangerous');
    }
    // Microsoft's own identity redirects have no hyphen and stay allowed.
    expect(classifyRedirectUri('msauth://com.x.y/abc')).toBe('ok');
  });

  it('RURI-003: a single-letter scheme is not a private-use scheme', () => {
    // 'c:\\tmp\\cb' parses with protocol 'c:', which is a Windows path, not a redirect.
    expect(classifyRedirectUri('c:\\tmp\\cb')).toBe('not_allowed');
  });
});

describe('redirectUriMatches', () => {
  it('RURI-010: byte-exact matches win, including percent-encoding', () => {
    const uri = 'workbuddy://workbuddy/mcp/connector%3A/oauth/callback';
    expect(redirectUriMatches(uri, uri)).toBe(true);
    expect(redirectUriMatches(uri, 'workbuddy://workbuddy/mcp/connector:/oauth/callback')).toBe(false);
    expect(redirectUriMatches('https://a.example.com/cb', 'https://a.example.com/cb/')).toBe(false);
  });

  it('RURI-011: a loopback redirect may land on any port (RFC 8252 §7.3)', () => {
    expect(redirectUriMatches('http://127.0.0.1:8080/callback', 'http://127.0.0.1:54321/callback')).toBe(true);
    expect(redirectUriMatches('http://[::1]:8080/oauth/callback', 'http://[::1]:54321/oauth/callback')).toBe(true);
    expect(redirectUriMatches('http://localhost/cb?x=1', 'http://localhost:9999/cb?x=1')).toBe(true);
  });

  it('RURI-012: only the port is free, so path, query and host still match exactly', () => {
    expect(redirectUriMatches('http://127.0.0.1:8080/callback', 'http://127.0.0.1:54321/other')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1:8080/cb?x=1', 'http://127.0.0.1:54321/cb?x=2')).toBe(false);
    // The RFC does not allow localhost↔127.0.0.1 cross-matching.
    expect(redirectUriMatches('http://localhost:8080/cb', 'http://127.0.0.1:54321/cb')).toBe(false);
  });

  it('RURI-013: non-loopback and non-http URIs stay byte-exact', () => {
    expect(redirectUriMatches('https://a.example.com:8443/cb', 'https://a.example.com:9443/cb')).toBe(false);
    expect(redirectUriMatches('http://evil.example.com:80/cb', 'http://evil.example.com:81/cb')).toBe(false);
    expect(redirectUriMatches('https://localhost:8443/cb', 'https://localhost:9443/cb')).toBe(false);
    expect(redirectUriMatches('myapp://localhost:1/cb', 'myapp://localhost:2/cb')).toBe(false);
  });

  it('RURI-015: userinfo and fragment are compared, not silently dropped', () => {
    expect(redirectUriMatches('http://127.0.0.1:8080/cb', 'http://attacker@127.0.0.1:54321/cb')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1:8080/cb', 'http://127.0.0.1:54321/cb#evil')).toBe(false);
  });

  it('RURI-014: an unparseable side never matches', () => {
    expect(redirectUriMatches('not a url', 'http://127.0.0.1:1/cb')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1:1/cb', 'not a url')).toBe(false);
  });
});
