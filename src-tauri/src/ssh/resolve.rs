/*
 * Address resolution for outbound SSH.
 *
 * Rust's `ToSocketAddrs` (and `tokio::net::lookup_host`) short-circuits a
 * literal address: "68.183.223.138:22" is parsed straight into an IPv4
 * `SocketAddr` without ever consulting the resolver. On an IPv6-only network
 * behind NAT64/DNS64 — the normal shape of phone tethering and of several
 * mobile carriers — the machine has no usable IPv4 path at all, so that
 * connect fails immediately with EADDRNOTAVAIL ("Can't assign requested
 * address") even though the host is perfectly reachable through the NAT64
 * prefix. Hostnames keep working there because DNS64 answers with a
 * synthesized AAAA, which is why the failure looks arbitrary: saved hosts
 * stored as IPs die, saved hosts stored as names do not.
 *
 * macOS does not synthesize that address for a *literal* — `getaddrinfo`
 * returns the IPv4 address verbatim however it is asked — so the prefix is
 * discovered the way RFC 7050 prescribes (resolve `ipv4only.arpa`, whose AAAA
 * carries the well-known 192.0.0.170 inside the network's NAT64 prefix) and
 * the target is embedded into it. The synthesis is only attempted after a
 * direct attempt has already failed with "address not available", so a normal
 * dual-stack machine pays nothing and takes exactly the path it always did.
 */

use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use crate::types::error::SshError;

/// Resolve `host:port` into candidate addresses, in the resolver's own order.
pub async fn resolve_targets(host: &str, port: u16) -> Result<Vec<SocketAddr>, SshError> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| SshError::ConnectionFailed(format!("could not resolve {host}: {e}")))?
        .collect();
    if addrs.is_empty() {
        return Err(SshError::ConnectionFailed(format!(
            "could not resolve {host}"
        )));
    }
    Ok(addrs)
}

/// True when the OS refused the connect because no address of that family is
/// usable — what an IPv6-only host reports for every IPv4 destination.
pub fn is_family_unavailable(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("can't assign requested address")
        || message.contains("cannot assign requested address")
        || message.contains("address family not supported")
        || message.contains("network is unreachable")
}

/* The discovered prefix is stable for as long as the machine stays on one
 * network, and is only consulted on a failed connect, so a short TTL keeps a
 * network change from pinning a stale prefix without re-querying per attempt. */
const PREFIX_TTL: Duration = Duration::from_secs(60);
static NAT64_PREFIX: RwLock<Option<(Instant, Vec<[u8; 12]>)>> = RwLock::new(None);

/// NAT64 stand-ins for any IPv4 candidates, empty when the network has no
/// NAT64 (the overwhelmingly common case).
pub async fn nat64_fallbacks(targets: &[SocketAddr]) -> Vec<SocketAddr> {
    let v4: Vec<SocketAddr> = targets.iter().copied().filter(|a| a.is_ipv4()).collect();
    if v4.is_empty() {
        return Vec::new();
    }
    let prefixes = nat64_prefixes().await;
    let mut out = Vec::new();
    for addr in v4 {
        let IpAddr::V4(ip) = addr.ip() else { continue };
        let quad = ip.octets();
        for prefix in &prefixes {
            let mut bytes = [0u8; 16];
            bytes[..12].copy_from_slice(prefix);
            bytes[12..].copy_from_slice(&quad);
            out.push(SocketAddr::new(
                IpAddr::V6(Ipv6Addr::from(bytes)),
                addr.port(),
            ));
        }
    }
    out
}

/* RFC 7050: `ipv4only.arpa` resolves to 192.0.0.170 / 192.0.0.171, so a AAAA
 * answer is that literal wrapped in the network's NAT64 prefix. Only /96 is
 * derived — it is what DNS64 deployments use in practice, and a guess at a
 * shorter prefix would produce addresses that quietly go nowhere. */
async fn nat64_prefixes() -> Vec<[u8; 12]> {
    if let Some((seen, prefixes)) = NAT64_PREFIX.read().ok().and_then(|slot| slot.clone()) {
        if seen.elapsed() < PREFIX_TTL {
            return prefixes;
        }
    }
    let mut prefixes: Vec<[u8; 12]> = Vec::new();
    if let Ok(addrs) = tokio::net::lookup_host(("ipv4only.arpa", 0)).await {
        for addr in addrs {
            let IpAddr::V6(ip) = addr.ip() else { continue };
            let bytes = ip.octets();
            let embedded = &bytes[12..];
            if embedded == [192, 0, 0, 170] || embedded == [192, 0, 0, 171] {
                let mut prefix = [0u8; 12];
                prefix.copy_from_slice(&bytes[..12]);
                if !prefixes.contains(&prefix) {
                    prefixes.push(prefix);
                }
            }
        }
    }
    if let Ok(mut slot) = NAT64_PREFIX.write() {
        *slot = Some((Instant::now(), prefixes.clone()));
    }
    prefixes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_ipv4_literal_resolves_with_its_port() {
        let addrs = resolve_targets("127.0.0.1", 2222).await.expect("resolve");
        assert!(addrs.iter().all(|addr| addr.port() == 2222));
        assert!(addrs.iter().any(|addr| addr.ip().is_loopback()));
    }

    #[tokio::test]
    async fn a_name_that_cannot_resolve_reports_the_host() {
        let error = resolve_targets("no-such-host.invalid", 22)
            .await
            .expect_err("an unresolvable name must fail");
        assert!(
            error.to_string().contains("no-such-host.invalid"),
            "the failure must name the host, got {error}"
        );
    }

    /* The exact wording macOS, Linux, and Windows use when the destination's
     * address family has no usable route — the signal that a NAT64 stand-in is
     * worth trying. Anything else (refused, timed out, unknown host) is a real
     * answer from the network and must not trigger a retry. */
    #[test]
    fn only_family_failures_ask_for_a_nat64_retry() {
        assert!(is_family_unavailable(
            "Can't assign requested address (os error 49)"
        ));
        assert!(is_family_unavailable(
            "Cannot assign requested address (os error 99)"
        ));
        assert!(is_family_unavailable(
            "Network is unreachable (os error 101)"
        ));
        assert!(!is_family_unavailable("Connection refused (os error 61)"));
        assert!(!is_family_unavailable("Connection timed out"));
        assert!(!is_family_unavailable("nodename nor servname provided"));
    }

    /* An IPv6-only target has nothing to translate, so no query is made and no
     * stand-in is produced. */
    #[tokio::test]
    async fn an_ipv6_target_gets_no_nat64_stand_in() {
        let v6: SocketAddr = "[::1]:22".parse().unwrap();
        assert!(nat64_fallbacks(&[v6]).await.is_empty());
    }

    /* Embedding is the low 32 bits of the prefix, per RFC 6052 /96. */
    #[test]
    fn an_address_embeds_into_the_well_known_prefix() {
        let prefix: [u8; 12] = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];
        let mut bytes = [0u8; 16];
        bytes[..12].copy_from_slice(&prefix);
        bytes[12..].copy_from_slice(&[68, 183, 223, 138]);
        assert_eq!(Ipv6Addr::from(bytes).to_string(), "64:ff9b::44b7:df8a",);
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /* Opt-in: proves the fallback on a real IPv6-only/NAT64 network. Set
     * OMNISSH_NAT64_TARGET=host:port on such a network to run it. */
    #[tokio::test]
    async fn a_v4_literal_becomes_reachable_through_nat64() {
        let Ok(target) = std::env::var("OMNISSH_NAT64_TARGET") else {
            eprintln!("skipped: set OMNISSH_NAT64_TARGET=host:port to run the live NAT64 check");
            return;
        };
        let (host, port) = target.rsplit_once(':').expect("host:port");
        let port: u16 = port.parse().expect("port");
        let targets = resolve_targets(host, port).await.expect("resolve");

        let direct = tokio::net::TcpStream::connect(targets[0]).await;
        let direct_error = direct.err().map(|e| e.to_string());
        let Some(error) = direct_error else {
            eprintln!("skipped: {} is reachable over IPv4 here", targets[0]);
            return;
        };
        assert!(
            is_family_unavailable(&error),
            "expected an address-family failure, got {error}"
        );

        let fallbacks = nat64_fallbacks(&targets).await;
        assert!(
            !fallbacks.is_empty(),
            "NAT64 prefix discovery found nothing"
        );
        let mut connected = false;
        for addr in &fallbacks {
            if tokio::net::TcpStream::connect(*addr).await.is_ok() {
                eprintln!("connected through {addr}");
                connected = true;
                break;
            }
        }
        assert!(connected, "no NAT64 stand-in connected: {fallbacks:?}");
    }
}
