output "ipv4_address" {
  description = "The IPv4 address of the Hetzner Cloud server"
  value       = hcloud_server.my_server.ipv4_address
}

output "ipv6_address" {
  description = "The IPv6 address of the Hetzner Cloud server"
  value       = hcloud_server.my_server.ipv6_address
}

output "fqdn" {
  description = "The fully qualified domain name (FQDN) of the Hetzner Cloud server"
  value       = format("%s.%s", var.hcloud_hostname, var.cf_zone_name)
}
