output "instance_id" {
  description = "ID of the compute instance"
  value       = openstack_compute_instance_v2.this.id
}

output "port_id" {
  description = "ID of the networking port"
  value       = openstack_networking_port_v2.this.id
}

output "volume_id" {
  description = "ID of the block storage volume"
  value       = openstack_blockstorage_volume_v3.this.id
}

output "ipv4_address" {
  description = "First IPv4 address from the port"
  value = try(
    [for ip in openstack_networking_port_v2.this.all_fixed_ips : ip if can(regex("^\\d+\\.\\d+\\.\\d+\\.\\d+$", ip))][0],
    null
  )
}

output "ipv6_address" {
  description = "First IPv6 address from the port"
  value = try(
    [for ip in openstack_networking_port_v2.this.all_fixed_ips : ip if can(regex(":", ip))][0],
    null
  )
}
