data "hcloud_ssh_keys" "all" {}

resource "hcloud_server" "my_server" {
  name         = var.hcloud_hostname
  image        = var.hcloud_server_image
  server_type  = var.hcloud_server_type
  location     = var.hcloud_server_location
  ssh_keys = data.hcloud_ssh_keys.all.ssh_keys.*.name
}

data "cloudflare_zone" "my_zone" {
  name = var.cf_zone_name
}

resource "cloudflare_record" "my_a_record" {
  zone_id = data.cloudflare_zone.my_zone.id
  name    = var.hcloud_hostname
  type    = "A"
  content = hcloud_server.my_server.ipv4_address
  comment = format("FQDN record for hcloud_server '%s' (%s)", var.hcloud_hostname, var.timestamp)
}

resource "cloudflare_record" "my_aaaa_record" {
  zone_id = data.cloudflare_zone.my_zone.id
  name    = var.hcloud_hostname
  type    = "AAAA"
  content = hcloud_server.my_server.ipv6_address
  comment = format("FQDN record for hcloud_server '%s' (%s)", var.hcloud_hostname, var.timestamp)
}

resource "cloudflare_record" "my_cname_record" {
  zone_id = data.cloudflare_zone.my_zone.id
  name    = format("*.%s", var.hcloud_hostname)
  type    = "CNAME"
  content = format("%s.%s.", var.hcloud_hostname, var.cf_zone_name)
  comment = format("Wildcard subdomain record for hcloud_server '%s' (%s)", var.hcloud_hostname, var.timestamp)
}
