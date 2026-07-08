resource "openstack_networking_port_v2" "this" {
  name               = "${var.hostname}-port"
  network_id         = var.network_id
  security_group_ids = var.security_group_ids
  tags               = [for k, v in var.labels : "${k}:${v}"]

  dynamic "fixed_ip" {
    for_each = var.fixed_ips
    content {
      subnet_id  = fixed_ip.value.subnet_id
      ip_address = fixed_ip.value.ip_address
    }
  }
}

resource "openstack_blockstorage_volume_v3" "this" {
  name        = "${var.hostname}-disk"
  size        = var.disk_size
  volume_type = var.volume_type
  image_id    = var.image_id
  metadata    = var.labels
}

resource "openstack_compute_instance_v2" "this" {
  name        = var.hostname
  flavor_name = var.flavor

  block_device {
    source_type      = "volume"
    destination_type = "volume"
    uuid             = openstack_blockstorage_volume_v3.this.id
  }

  network {
    port = openstack_networking_port_v2.this.id
  }

  key_pair  = var.key_pair_name
  user_data = var.user_data
  metadata  = var.labels

  lifecycle {
    ignore_changes = [user_data]
  }
}
