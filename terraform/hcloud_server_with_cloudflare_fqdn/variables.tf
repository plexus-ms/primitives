variable "hcloud_hostname" {
  description = "The hostname to configure (will be used as server hostname and subdomain)"
  type        = string
}

variable "cf_zone_name" {
  description = "The Cloudflare DNS zone name to use for the FQDN records (e.g. 'acme.org')"
  type        = string
}

variable "hcloud_server_type" {
  description = "The Hetzner Cloud server type to use (e.g. 'cx22')"
  type        = string
  default     = "cx22"
}

variable "hcloud_server_image" {
  description = "The Hetzner Cloud server image to use (e.g. 'ubuntu-24.04')"
  type        = string
  default     = "ubuntu-24.04"
}

variable "hcloud_server_location" {
  description = "The Hetzner Cloud data center location to use (e.g. 'fsn1')"
  type        = string
  default     = "fsn1"
}

variable "timestamp" {
  description = "Provide a timestamp for reference that will be used in the Cloudflare record comments, e.g. '2024-12-08'"
  type        = string
  default     = ""
}
