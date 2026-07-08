# hcloud_server_with_cloudflare_fqdn

This Terraform module is designed for the creation of a server on Hetzner Cloud with automatic provisioning of appropriate Cloudflare DNS records.

## How to use this module

- Make sure that the `cloudflare/cloudflare` and `hetznercloud/hcloud` providers are configured with API tokens outside of this module.
- Call the module with the variable inputs:
  - `cf_zone_name`: Specify the domain you'd like to use for the server's FQDN (mandatory).
  - `hostname`: Specify the hostname you'd like your server to have (mandatory).
  - `hcloud_server_type`, `hcloud_server_image` and `hcloud_server_location`: Optional: Specify the desired server type, image to install, and datacenter location to use on Hetzner Cloud. If you leave out these three, they will default to `cx22` (2 vCPU, 4 GB RAM, 40 GB SSD, about €4/mo), `ubuntu-24.04` and `fsn-1` (Hetzner's Falkenstein location), respectively.
  - `timestamp`: Optional: Specify a timestamp that will be used in the comments of the created resources (useful for future you!!).

## Which DNS records will be created?

Let's say you've set `cf_zone_name = "acme.org"` and `hostname = "demo-server"`.
Then this module will create an A and an AAAA record at `demo-server.acme.org` with the IPv4 and IPv6 addresses of the Hetzner server as well as a CNAME record at `*.demo-server.acme.org` pointing to `demo-server.acme.org`.

## A note about SSH key behavior

The module does not take SSH keys as input variables – SSH keys need to be uploaded to Hetzner Cloud before using the module!

Currently, this module is configured to add all SSH keys to the newly created server that are present in the Hetzner Cloud project (which is specified by the hcloud provider configuration and its token).
If there are no SSH keys in the project, none will be added. (Hetzner's default behavior in this case is to send an email with the root password.)

## Example use

```hcl
terraform {
  required_providers {
    hcloud = {
      source = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
    cloudflare = {
      source = "cloudflare/cloudflare"
      version = "~> 4.49"
    }
  }
}

provider "hcloud" {
  token = "<insert hcloud token here or get from var>"
}

provider "cloudflare" {
  api_token = "<insert cloudflare api_token here or get from var>"
}

module "my_hcloud_server" {
  source                 = "<insert relative path to this module here>"
  timestamp              = "2024-12-08"

  cf_zone_name           = "acme.org"

  hcloud_hostname        = "demo-server"
  hcloud_server_type     = "cx22"
  hcloud_server_image    = "ubuntu-24.04"
  hcloud_server_location = "fsn1"
}

```
