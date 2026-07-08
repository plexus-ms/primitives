variable "hostname" {
  description = "VM name, used for resource naming"
  type        = string
}

variable "flavor" {
  description = "OpenStack flavor name"
  type        = string
}

variable "disk_size" {
  description = "Volume size in GB"
  type        = number
}

variable "image_id" {
  description = "OS image ID"
  type        = string
}

variable "network_id" {
  description = "Network to attach port to"
  type        = string
}

variable "key_pair_name" {
  description = "SSH key pair name"
  type        = string
}

variable "security_group_ids" {
  description = "Security groups for the port"
  type        = list(string)
  default     = []
}

variable "volume_type" {
  description = "Storage tier (uses provider default if null)"
  type        = string
  default     = null
}

variable "user_data" {
  description = "Cloud-init content"
  type        = string
  default     = ""
}

variable "fixed_ips" {
  description = "Static IPs; DHCP if empty"
  type = list(object({
    subnet_id  = string
    ip_address = string
  }))
  default = []
}

variable "labels" {
  description = "Key-value labels applied as instance/volume metadata and port tags"
  type        = map(string)
  default     = {}
}

