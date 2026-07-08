# openstack_server

Generic Terraform module that creates an OpenStack VM consisting of a networking port, a block storage volume, and a compute instance. Accepts resolved IDs — the module has no opinions about naming conventions, org-specific defaults, or cloud-init content.

## How to use this module

- Make sure that the `terraform-provider-openstack/openstack` provider is configured outside of this module.
- Call the module with the required variable inputs (see below).
- The module creates three resources: `openstack_networking_port_v2`, `openstack_blockstorage_volume_v3`, and `openstack_compute_instance_v2`.

## Variables

| Variable | Type | Required | Default | Purpose |
|---|---|---|---|---|
| `hostname` | `string` | yes | — | VM name, used for resource naming (`<hostname>-port`, `<hostname>-disk`) |
| `flavor` | `string` | yes | — | OpenStack flavor name |
| `disk_size` | `number` | yes | — | Volume size in GB |
| `image_id` | `string` | yes | — | OS image ID |
| `network_id` | `string` | yes | — | Network to attach the port to |
| `key_pair_name` | `string` | yes | — | SSH key pair name |
| `security_group_ids` | `list(string)` | no | `[]` | Security group IDs for the port |
| `volume_type` | `string` | no | `null` | Storage tier (provider default if null) |
| `user_data` | `string` | no | `""` | Cloud-init content |
| `fixed_ips` | `list(object({subnet_id, ip_address}))` | no | `[]` | Static IPs; DHCP if empty |
| `labels` | `map(string)` | no | `{}` | Key-value labels applied as instance/volume metadata and port tags |

## Outputs

| Output | Description |
|---|---|
| `instance_id` | ID of the compute instance |
| `port_id` | ID of the networking port |
| `volume_id` | ID of the block storage volume |
| `ipv4_address` | First IPv4 address from the port (or `null`) |
| `ipv6_address` | First IPv6 address from the port (or `null`) |

## Example use

```hcl
module "my_server" {
  source = "git::https://github.com/davidjalbers/itops-terraform.git//openstack_server"

  hostname      = "my-server"
  flavor        = "medium"
  disk_size     = 50
  image_id      = data.openstack_images_image_v2.ubuntu.id
  network_id    = data.openstack_networking_network_v2.public.id
  key_pair_name = data.openstack_compute_keypair_v2.my_key.name

  security_group_ids = [
    data.openstack_networking_secgroup_v2.any_out.id,
    data.openstack_networking_secgroup_v2.web_in.id,
  ]

  volume_type = "replicated_gold"

  fixed_ips = [
    {
      subnet_id  = data.openstack_networking_subnet_v2.public4.id
      ip_address = "10.0.0.5"
    },
  ]

  user_data = templatefile("${path.module}/cloud-init.tftpl", {
    hostname = "my-server"
  })

  labels = { managed_by = "terraform" }
}
```

## Design notes

- `user_data` has `lifecycle { ignore_changes }` on the compute instance, since cloud-init only runs on first boot and subsequent changes would trigger unnecessary replacements.
- The module uses `dynamic "fixed_ip"` blocks, so passing an empty list results in DHCP assignment.
